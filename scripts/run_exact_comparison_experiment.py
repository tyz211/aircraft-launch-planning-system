import json
import random
import statistics
import sys
import time
from copy import deepcopy
from pathlib import Path

import pulp


REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python_backend"))

from app import build_tasks, normalize_workflow  # noqa: E402
from ga import DEFAULT_WORKFLOW, GeneticAlgorithm, SimulatedAnnealing  # noqa: E402


SMALL_RESOURCES = {
    "机务人员": 3,
    "军械人员": 2,
    "航电人员": 1,
    "特设人员": 1,
    "加油车": 1,
    "挂弹车": 1,
    "测试仪": 1,
}


def deterministic_workflow():
    workflow = deepcopy(DEFAULT_WORKFLOW)
    for task in workflow:
        task["uncertainty"]["enabled"] = False
    return normalize_workflow(workflow)


def solve_exact_mip(num_planes, workflow, resources, time_limit=120):
    tasks, _ = build_tasks(num_planes, workflow)
    horizon = sum(task.duration for task in tasks.values())
    model = pulp.LpProblem("small_rcpsp_exact", pulp.LpMinimize)
    start_vars = {}
    task_start_times = {}
    task_end_times = {}

    for task_id, task in tasks.items():
        feasible_times = range(0, horizon - task.duration + 1)
        start_vars[task_id] = {
            t: pulp.LpVariable(f"x_{task_id}_{t}", cat="Binary")
            for t in feasible_times
        }
        model += pulp.lpSum(start_vars[task_id].values()) == 1
        task_start_times[task_id] = pulp.lpSum(t * var for t, var in start_vars[task_id].items())
        task_end_times[task_id] = pulp.lpSum((t + task.duration) * var for t, var in start_vars[task_id].items())

    for task_id, task in tasks.items():
        for predecessor in task.predecessors:
            model += task_start_times[task_id] >= task_end_times[predecessor]

    for resource, capacity in resources.items():
        for tau in range(horizon):
            usage_terms = []
            for task_id, task in tasks.items():
                demand = int(task.resources.get(resource, 0))
                if demand <= 0:
                    continue
                for start_time, var in start_vars[task_id].items():
                    if start_time <= tau < start_time + task.duration:
                        usage_terms.append(demand * var)
            if usage_terms:
                model += pulp.lpSum(usage_terms) <= capacity

    makespan = pulp.LpVariable("makespan", lowBound=0, upBound=horizon, cat="Integer")
    for task_id in tasks:
        model += makespan >= task_end_times[task_id]
    model += makespan

    started = time.perf_counter()
    solver = pulp.PULP_CBC_CMD(msg=False, timeLimit=time_limit)
    status = model.solve(solver)
    elapsed = round(time.perf_counter() - started, 3)

    if pulp.LpStatus[status] not in ("Optimal", "Integer Feasible"):
        raise RuntimeError(f"MIP failed with status {pulp.LpStatus[status]}")

    schedule = {}
    for task_id, vars_by_time in start_vars.items():
        chosen_start = next(
            start_time
            for start_time, var in vars_by_time.items()
            if (var.value() or 0) > 0.5
        )
        schedule[task_id] = [chosen_start, chosen_start + tasks[task_id].duration]

    return {
        "status": pulp.LpStatus[status],
        "makespan": int(round(makespan.value())),
        "elapsed": elapsed,
        "schedule": schedule,
    }


def run_heuristic(method, num_planes, workflow, resources, runs, ga_pop_size=12, ga_gens=10, sa_gens=80):
    makespans = []
    elapsed_values = []

    for run_idx in range(runs):
        seed = 1000 + run_idx
        random.seed(seed)
        tasks, all_ids = build_tasks(num_planes, workflow)
        started = time.perf_counter()
        if method == "GA":
            solver = GeneticAlgorithm(
                tasks,
                all_ids,
                resources,
                pop_size=ga_pop_size,
                gens=ga_gens,
                sample_count=1,
                worker_count=1,
            )
        elif method == "SA":
            solver = SimulatedAnnealing(
                tasks,
                all_ids,
                resources,
                gens=sa_gens,
                sample_count=1,
                worker_count=1,
            )
        else:
            raise ValueError(method)

        _, makespan, _ = solver.run()
        elapsed = round(time.perf_counter() - started, 3)
        makespans.append(float(makespan))
        elapsed_values.append(elapsed)

    return {
        "runs": runs,
        "best_makespan": min(makespans),
        "avg_makespan": round(statistics.mean(makespans), 2),
        "std_makespan": round(statistics.pstdev(makespans), 2),
        "avg_elapsed": round(statistics.mean(elapsed_values), 3),
        "all_makespans": makespans,
    }


def add_gap(metrics, optimum):
    best_gap = round((metrics["best_makespan"] - optimum) / optimum * 100, 2)
    avg_gap = round((metrics["avg_makespan"] - optimum) / optimum * 100, 2)
    metrics["best_gap_pct"] = best_gap
    metrics["avg_gap_pct"] = avg_gap
    return metrics


def run_experiment():
    workflow = deterministic_workflow()
    num_planes = 3
    exact = solve_exact_mip(num_planes, workflow, SMALL_RESOURCES, time_limit=120)
    optimum = exact["makespan"]

    ga = add_gap(run_heuristic("GA", num_planes, workflow, SMALL_RESOURCES, runs=10, ga_pop_size=12, ga_gens=10), optimum)
    sa = add_gap(run_heuristic("SA", num_planes, workflow, SMALL_RESOURCES, runs=10, sa_gens=80), optimum)

    return {
        "meta": {
            "numPlanes": num_planes,
            "workflowTaskCount": len(workflow),
            "globalTaskCount": num_planes * len(workflow),
            "resources": SMALL_RESOURCES,
            "gaParams": {"popSize": 12, "gens": 10, "sampleCount": 1},
            "saParams": {"gens": 80, "sampleCount": 1},
            "runsPerHeuristic": 10,
        },
        "exact": exact,
        "ga": ga,
        "sa": sa,
    }


def main():
    results = run_experiment()
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
