import random

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


def normalize_base_schedule(raw_schedule, tasks):
    if not isinstance(raw_schedule, dict) or not raw_schedule:
        raise ValueError("baseScheduled must be an object")

    normalized = {}
    for task_id, window in raw_schedule.items():
        if task_id not in tasks:
            raise ValueError(f"baseScheduled references unknown task {task_id}")
        if not isinstance(window, (list, tuple)) or len(window) != 2:
            raise ValueError(f"task {task_id} schedule window must contain start and end")

        start = int(window[0])
        end = int(window[1])
        if start < 0 or end < start:
            raise ValueError(f"task {task_id} schedule window is invalid")

        normalized[task_id] = [start, end]

    missing_tasks = [task_id for task_id in tasks if task_id not in normalized]
    if missing_tasks:
        raise ValueError("baseScheduled is missing tasks from the original schedule")

    return normalized


def normalize_failure_rules(raw_rules, workflow_ids):
    if not isinstance(raw_rules, list):
        raise ValueError("failureRules must be an array")

    normalized = []
    for rule in raw_rules:
        if not isinstance(rule, dict):
            raise ValueError("failureRules contains an invalid rule")

        task_id = str(rule.get("taskId", "")).strip()
        if not task_id:
            raise ValueError("failureRules contains a rule without taskId")
        if task_id not in workflow_ids:
            raise ValueError(f"failure rule references unknown workflow task {task_id}")

        enabled = bool(rule.get("enabled", True))
        probability = float(rule.get("probability", 0))
        if probability < 0 or probability > 1:
            raise ValueError(f"failure rule probability for {task_id} must be between 0 and 1")

        if enabled:
            normalized.append({"taskId": task_id, "probability": probability})

    if not normalized:
        raise ValueError("at least one failure rule must be enabled")

    return normalized


def normalize_target_planes(raw_target_planes, num_planes):
    if isinstance(raw_target_planes, list):
        plane_values = raw_target_planes
    elif raw_target_planes is None:
        plane_values = []
    else:
        plane_values = [raw_target_planes]

    normalized = []
    for value in plane_values:
        plane_id = int(value)
        if plane_id <= 0 or plane_id > num_planes:
            raise ValueError("targetPlanes must be within the original fleet range")
        if plane_id not in normalized:
            normalized.append(plane_id)

    if not normalized:
        raise ValueError("at least one target plane must be selected")

    return sorted(normalized)


def build_failure_candidates(target_planes, failure_rules, schedule, tasks, iteration=1):
    candidates = []
    planes_with_candidates = set()

    for plane_id in target_planes:
        plane_has_candidate = False
        for rule in failure_rules:
            global_task_id = f"A{plane_id}_{rule['taskId']}"
            schedule_window = schedule.get(global_task_id)
            task = tasks.get(global_task_id)
            if task is None or schedule_window is None:
                continue

            plane_has_candidate = True
            start, end = schedule_window
            roll = random.random()
            candidate = {
                "taskId": task.type,
                "globalTaskId": global_task_id,
                "taskName": task.name,
                "planeId": plane_id,
                "probability": round(rule["probability"], 4),
                "roll": round(roll, 4),
                "start": start,
                "end": end,
                "triggered": roll < rule["probability"],
                "iteration": iteration,
            }
            candidates.append(candidate)

        if plane_has_candidate:
            planes_with_candidates.add(plane_id)

    candidates.sort(key=lambda item: (item["end"], item["start"], item["planeId"], item["taskId"]))
    return candidates, planes_with_candidates


def build_reschedule_problem(workflow, current_tasks, current_schedule, failed_plane_id, failure_time, replacement_plane_id):
    fixed_ids = sorted(task_id for task_id, window in current_schedule.items() if task_id in current_tasks and window[0] < failure_time)

    reschedule_tasks = {}
    reschedule_ids = []
    removed_ids = []

    for task_id, task in current_tasks.items():
        task_start = current_schedule[task_id][0]

        if task_start < failure_time:
            reschedule_tasks[task_id] = task
            continue

        if task.plane_id == failed_plane_id:
            removed_ids.append(task_id)
            continue

        reschedule_tasks[task_id] = task
        reschedule_ids.append(task_id)

    fixed_schedule = {task_id: current_schedule[task_id] for task_id in fixed_ids if task_id in reschedule_tasks}
    release_times = {task_id: failure_time for task_id in reschedule_ids}

    replacement_map = {}
    for workflow_task in workflow:
        global_task_id = f"A{replacement_plane_id}_{workflow_task['id']}"
        replacement_map[workflow_task["id"]] = global_task_id

    for workflow_task in workflow:
        task_id = replacement_map[workflow_task["id"]]
        predecessors = [replacement_map[predecessor] for predecessor in workflow_task["predecessors"]]
        display_duration = round(workflow_task["uncertainty"]["mean"]) if workflow_task["uncertainty"]["enabled"] else workflow_task["duration"]
        reschedule_tasks[task_id] = Task(
            id=task_id,
            plane_id=replacement_plane_id,
            type=workflow_task["id"],
            name=workflow_task["name"],
            duration=max(1, int(display_duration)),
            resources=workflow_task["resources"],
            predecessors=predecessors,
            uncertainty=workflow_task["uncertainty"],
        )
        reschedule_ids.append(task_id)
        release_times[task_id] = failure_time

    return reschedule_tasks, reschedule_ids, fixed_schedule, release_times, fixed_ids, removed_ids, replacement_plane_id


def calculate_actual_makespan(schedule):
    return max((window[1] for window in schedule.values()), default=0)


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
            runner = GeneticAlgorithm(tasks, all_ids, normalized_resources, pop_size, gens, sample_count, worker_count)
        elif algorithm == "SA":
            runner = SimulatedAnnealing(tasks, all_ids, normalized_resources, gens, sample_count, worker_count)
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


@app.route("/api/reschedule", methods=["POST"])
def reschedule():
    data = request.get_json(silent=True) or {}

    try:
        num_planes = int(data.get("numPlanes", 12))
        pop_size = int(data.get("popSize", 50))
        gens = int(data.get("gens", 100))
        sample_count = int(data.get("sampleCount", 100))
        worker_count = int(data.get("workers", 0) or 0)
        raw_target_planes = data.get("targetPlanes", data.get("targetPlane"))
        resources = data.get("resources", {})
        algorithm = data.get("algorithm", "GA")
        workflow = normalize_workflow(data.get("workflow"))
        raw_base_makespan = data.get("baseMakespan")

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

        workflow_ids = {task["id"] for task in workflow}
        target_planes = normalize_target_planes(raw_target_planes, num_planes)
        failure_rules = normalize_failure_rules(data.get("failureRules"), workflow_ids)
        original_tasks, _ = build_tasks(num_planes, workflow)
        base_schedule = normalize_base_schedule(data.get("baseScheduled"), original_tasks)
        base_average_makespan = (
            float(raw_base_makespan) if raw_base_makespan is not None else calculate_actual_makespan(base_schedule)
        )
        current_tasks = original_tasks
        current_schedule = base_schedule
        remaining_target_planes = list(target_planes)
        candidate_failures = []
        failure_events = []
        replacement_plane_ids = []
        frozen_ids = set()
        removed_ids = set()
        combined_history = []
        history_offset = 0
        next_plane_id = max((task.plane_id for task in current_tasks.values()), default=num_planes)
        final_average_makespan = calculate_actual_makespan(base_schedule)

        while remaining_target_planes:
            stage_candidates, planes_with_candidates = build_failure_candidates(
                remaining_target_planes,
                failure_rules,
                current_schedule,
                current_tasks,
                len(failure_events) + 1,
            )
            candidate_failures.extend(stage_candidates)
            remaining_target_planes = [plane_id for plane_id in remaining_target_planes if plane_id in planes_with_candidates]
            failure_event = next((candidate for candidate in stage_candidates if candidate["triggered"]), None)

            if failure_event is None:
                break

            failure_events.append(failure_event)
            remaining_target_planes = [plane_id for plane_id in remaining_target_planes if plane_id != failure_event["planeId"]]
            next_plane_id += 1

            (
                reschedule_tasks,
                reschedule_ids,
                fixed_schedule,
                release_times,
                stage_fixed_ids,
                stage_removed_ids,
                replacement_plane_id,
            ) = build_reschedule_problem(
                workflow,
                current_tasks,
                current_schedule,
                failure_event["planeId"],
                failure_event["end"],
                next_plane_id,
            )

            frozen_ids.update(stage_fixed_ids)
            removed_ids.update(stage_removed_ids)
            replacement_plane_ids.append(replacement_plane_id)

            if algorithm == "GA":
                runner = GeneticAlgorithm(
                    reschedule_tasks,
                    reschedule_ids,
                    normalized_resources,
                    pop_size,
                    gens,
                    sample_count,
                    worker_count,
                    fixed_schedule,
                    release_times,
                )
            elif algorithm == "SA":
                runner = SimulatedAnnealing(
                    reschedule_tasks,
                    reschedule_ids,
                    normalized_resources,
                    gens,
                    sample_count,
                    worker_count,
                    fixed_schedule,
                    release_times,
                )
            else:
                raise ValueError("algorithm must be GA or SA")

            scheduled, final_average_makespan, history = runner.run()
            combined_history.extend(
                {"gen": point["gen"] + history_offset, "bestMs": point["bestMs"]}
                for point in history
            )
            history_offset += gens
            current_tasks = reschedule_tasks
            current_schedule = scheduled

        if not failure_events:
            actual_makespan = calculate_actual_makespan(base_schedule)
            return jsonify(
                {
                    "scheduled": base_schedule,
                    "makespan": round(base_average_makespan, 2),
                    "actualMakespan": actual_makespan,
                    "history": [],
                    "tasks": serialize_tasks(original_tasks),
                    "sampleCount": sample_count,
                    "workers": worker_count,
                    "triggered": False,
                    "failureEvent": None,
                    "failureEvents": [],
                    "candidateFailures": candidate_failures,
                    "replacementPlaneId": None,
                    "replacementPlaneIds": [],
                    "targetPlanes": target_planes,
                    "frozenTaskIds": [],
                    "removedTaskIds": [],
                }
            )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    actual_makespan = calculate_actual_makespan(current_schedule)
    return jsonify(
        {
            "scheduled": current_schedule,
            "makespan": final_average_makespan,
            "actualMakespan": actual_makespan,
            "history": combined_history,
            "tasks": serialize_tasks(current_tasks),
            "sampleCount": sample_count,
            "workers": worker_count,
            "triggered": True,
            "failureEvent": failure_events[0],
            "failureEvents": failure_events,
            "candidateFailures": candidate_failures,
            "replacementPlaneId": replacement_plane_ids[0] if replacement_plane_ids else None,
            "replacementPlaneIds": replacement_plane_ids,
            "targetPlanes": target_planes,
            "frozenTaskIds": sorted(frozen_ids),
            "removedTaskIds": sorted(removed_ids),
        }
    )


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=15050)
