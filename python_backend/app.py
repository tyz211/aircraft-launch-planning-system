from flask import Flask, jsonify, request
from flask_cors import CORS

from ga import DEFAULT_WORKFLOW, GeneticAlgorithm, SimulatedAnnealing, Task

app = Flask(__name__)
CORS(app)


def normalize_uncertainty(task_id, duration, raw_uncertainty):
    uncertainty = raw_uncertainty if isinstance(raw_uncertainty, dict) else {}
    enabled = bool(uncertainty.get("enabled", False))
    mean = float(uncertainty.get("mean", duration))
    std_dev = float(uncertainty.get("stdDev", 0))

    if mean <= 0:
        raise ValueError(f"task {task_id} uncertainty mean must be positive")
    if std_dev < 0:
        raise ValueError(f"task {task_id} uncertainty stdDev must not be negative")

    return {"enabled": enabled, "mean": mean, "stdDev": std_dev}


def normalize_workflow(raw_workflow):
    workflow = raw_workflow if isinstance(raw_workflow, list) and raw_workflow else DEFAULT_WORKFLOW
    normalized = []

    for task in workflow:
        task_id = str(task.get("id", "")).strip()
        if not task_id:
            raise ValueError("workflow contains a task without id")

        name = str(task.get("name", task_id)).strip() or task_id
        duration = int(task.get("duration", 1))
        resources = task.get("resources", {})
        predecessors = task.get("predecessors", [])

        if duration <= 0:
            raise ValueError(f"task {task_id} duration must be positive")
        if not isinstance(resources, dict):
            raise ValueError(f"task {task_id} resources must be an object")
        if not isinstance(predecessors, list):
            raise ValueError(f"task {task_id} predecessors must be an array")

        normalized.append(
            {
                "id": task_id,
                "name": name,
                "duration": duration,
                "resources": {str(res): int(amount) for res, amount in resources.items() if int(amount) > 0},
                "predecessors": [str(predecessor) for predecessor in predecessors],
                "uncertainty": normalize_uncertainty(task_id, duration, task.get("uncertainty")),
            }
        )

    workflow_ids = {task["id"] for task in normalized}
    if len(workflow_ids) != len(normalized):
        raise ValueError("workflow contains duplicate task ids")

    for task in normalized:
        for predecessor in task["predecessors"]:
            if predecessor not in workflow_ids:
                raise ValueError(f"task {task['id']} references unknown predecessor {predecessor}")

    return normalized


def build_tasks(num_planes, workflow):
    tasks = {}
    all_ids = []

    for plane_id in range(1, num_planes + 1):
        plane_map = {}
        for task in workflow:
            global_id = f"A{plane_id}_{task['id']}"
            plane_map[task["id"]] = global_id
            all_ids.append(global_id)

        for task in workflow:
            predecessors = [plane_map[predecessor] for predecessor in task["predecessors"]]
            display_duration = round(task["uncertainty"]["mean"]) if task["uncertainty"]["enabled"] else task["duration"]
            tasks[plane_map[task["id"]]] = Task(
                id=plane_map[task["id"]],
                plane_id=plane_id,
                type=task["id"],
                name=task["name"],
                duration=max(1, int(display_duration)),
                resources=task["resources"],
                predecessors=predecessors,
                uncertainty=task["uncertainty"],
            )

    return tasks, all_ids


def serialize_tasks(tasks):
    serialized = {}
    for task_id, task in tasks.items():
        serialized[task_id] = {
            "id": task.id,
            "plane_id": task.plane_id,
            "type": task.type,
            "name": task.name,
            "duration": task.duration,
            "resources": task.resources,
            "predecessors": task.predecessors,
            "uncertainty": task.uncertainty,
        }
    return serialized


@app.route("/api/optimize", methods=["POST"])
def optimize():
    data = request.get_json(silent=True) or {}

    try:
        num_planes = int(data.get("numPlanes", 12))
        pop_size = int(data.get("popSize", 50))
        gens = int(data.get("gens", 100))
        sample_count = int(data.get("sampleCount", 100))
        worker_count = int(data.get("workers", 0) or 0)
        resources = data.get("resources", {})
        algorithm = data.get("algorithm", "GA")
        workflow = normalize_workflow(data.get("workflow"))

        if num_planes <= 0:
            raise ValueError("numPlanes must be positive")
        if pop_size <= 0:
            raise ValueError("popSize must be positive")
        if gens <= 0:
            raise ValueError("gens must be positive")
        if sample_count <= 0:
            raise ValueError("sampleCount must be positive")
        if worker_count < 0:
            raise ValueError("workers must not be negative")
        if not isinstance(resources, dict):
            raise ValueError("resources must be an object")

        normalized_resources = {str(name): int(capacity) for name, capacity in resources.items()}
        for name, capacity in normalized_resources.items():
            if capacity < 0:
                raise ValueError(f"resource {name} capacity must not be negative")

        tasks, all_ids = build_tasks(num_planes, workflow)

        if algorithm == "GA":
            runner = GeneticAlgorithm(tasks, all_ids, normalized_resources, pop_size, gens, sample_count, worker_count or None)
        elif algorithm == "SA":
            runner = SimulatedAnnealing(tasks, all_ids, normalized_resources, gens, sample_count, worker_count or None)
        else:
            raise ValueError("algorithm must be GA or SA")

        scheduled, makespan, history = runner.run()
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    return jsonify(
        {
            "scheduled": scheduled,
            "makespan": makespan,
            "history": history,
            "tasks": serialize_tasks(tasks),
            "sampleCount": sample_count,
            "workers": worker_count,
        }
    )


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=15050)
