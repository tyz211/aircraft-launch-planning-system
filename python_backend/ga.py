from concurrent.futures import ProcessPoolExecutor
import math
from multiprocessing import cpu_count
import random


DEFAULT_WORKFLOW = [
    {
        "id": "F1",
        "name": "接收检查",
        "duration": 2,
        "resources": {"机务人员": 2},
        "predecessors": [],
        "uncertainty": {"enabled": False, "mean": 2, "stdDev": 0.5},
    },
    {
        "id": "F2",
        "name": "燃油加注",
        "duration": 4,
        "resources": {"加油车": 1, "机务人员": 1},
        "predecessors": ["F1"],
        "uncertainty": {"enabled": False, "mean": 4, "stdDev": 0.8},
    },
    {
        "id": "F3",
        "name": "挂弹作业",
        "duration": 2,
        "resources": {"挂弹车": 1, "军械人员": 2},
        "predecessors": ["F1"],
        "uncertainty": {"enabled": False, "mean": 2, "stdDev": 0.5},
    },
    {
        "id": "F4",
        "name": "航电检查",
        "duration": 2,
        "resources": {"航电人员": 1, "测试仪": 1},
        "predecessors": ["F1"],
        "uncertainty": {"enabled": False, "mean": 2, "stdDev": 0.5},
    },
    {
        "id": "F5",
        "name": "综合测试",
        "duration": 3,
        "resources": {"机务人员": 1, "航电人员": 1},
        "predecessors": ["F2", "F3", "F4"],
        "uncertainty": {"enabled": False, "mean": 3, "stdDev": 0.6},
    },
    {
        "id": "F6",
        "name": "最终确认",
        "duration": 1,
        "resources": {"特设人员": 1},
        "predecessors": ["F5"],
        "uncertainty": {"enabled": False, "mean": 1, "stdDev": 0.3},
    },
    {
        "id": "F7",
        "name": "发动机试车",
        "duration": 2,
        "resources": {"机务人员": 2},
        "predecessors": ["F6"],
        "uncertainty": {"enabled": False, "mean": 2, "stdDev": 0.5},
    },
    {
        "id": "F8",
        "name": "放飞指令",
        "duration": 1,
        "resources": {},
        "predecessors": ["F7"],
        "uncertainty": {"enabled": False, "mean": 1, "stdDev": 0.2},
    },
]


class Task:
    def __init__(self, id, plane_id, type, name, duration, resources, predecessors, uncertainty=None):
        self.id = id
        self.plane_id = plane_id
        self.type = type
        self.name = name
        self.duration = duration
        self.resources = resources
        self.predecessors = predecessors
        self.uncertainty = uncertainty or {"enabled": False, "mean": duration, "stdDev": 0}


def resolve_deterministic_duration(task):
    uncertainty = task.uncertainty or {}
    if uncertainty.get("enabled"):
        return max(1, int(round(float(uncertainty.get("mean", task.duration)))))
    return max(1, int(round(task.duration)))


def sample_duration(task):
    uncertainty = task.uncertainty or {}
    if uncertainty.get("enabled"):
        sampled = random.gauss(float(uncertainty.get("mean", task.duration)), float(uncertainty.get("stdDev", 0)))
        return max(1, int(round(sampled)))
    return resolve_deterministic_duration(task)


def sample_duration_with_rng(task, rng):
    uncertainty = task.uncertainty or {}
    if uncertainty.get("enabled"):
        sampled = rng.gauss(float(uncertainty.get("mean", task.duration)), float(uncertainty.get("stdDev", 0)))
        return max(1, int(round(sampled)))
    return resolve_deterministic_duration(task)


def build_duration_map(tasks, sampler):
    return {task_id: sampler(task) for task_id, task in tasks.items()}


def build_sampled_duration_map(tasks, seed):
    rng = random.Random(seed)
    return {task_id: sample_duration_with_rng(task, rng) for task_id, task in tasks.items()}


def default_worker_count():
    try:
        return max(1, min(8, cpu_count() - 1))
    except NotImplementedError:
        return 1


def ssgs_decode(priority_list, tasks, res_cap, durations=None):
    scheduled = {}
    completed = set()
    res_usage = []
    priority_positions = {tid: idx for idx, tid in enumerate(priority_list)}
    effective_durations = durations or build_duration_map(tasks, resolve_deterministic_duration)

    def get_usage(t):
        while len(res_usage) <= t:
            res_usage.append({k: 0 for k in res_cap})
        return res_usage[t]

    eligible = [tid for tid, task in tasks.items() if not task.predecessors]

    while eligible:
        curr_tid = min(eligible, key=lambda tid: priority_positions.get(tid, float("inf")))
        eligible.remove(curr_tid)
        task = tasks[curr_tid]
        task_duration = effective_durations[curr_tid]

        est = 0
        for predecessor in task.predecessors:
            if predecessor in scheduled:
                est = max(est, scheduled[predecessor][1])

        start_time = est
        while True:
            can_schedule = True
            for t in range(start_time, start_time + task_duration):
                usage = get_usage(t)
                for res, amt in task.resources.items():
                    if usage.get(res, 0) + amt > res_cap.get(res, 0):
                        can_schedule = False
                        break
                if not can_schedule:
                    break
            if can_schedule:
                break
            start_time += 1

        for t in range(start_time, start_time + task_duration):
            usage = get_usage(t)
            for res, amt in task.resources.items():
                usage[res] = usage.get(res, 0) + amt

        scheduled[curr_tid] = [start_time, start_time + task_duration]
        completed.add(curr_tid)

        for tid, task_obj in tasks.items():
            if tid not in completed and tid not in eligible:
                if all(pred in completed for pred in task_obj.predecessors):
                    eligible.append(tid)

    makespan = max((end for _, end in scheduled.values()), default=0)
    return scheduled, makespan


class SequenceEvaluator:
    def __init__(self, tasks, res_cap, sample_count=100, worker_count=None):
        self.tasks = tasks
        self.res_cap = res_cap
        self.sample_count = max(1, sample_count)
        self.worker_count = max(1, worker_count or default_worker_count())

    def evaluate(self, priority_list):
        sampled_makespans = []
        for _ in range(self.sample_count):
            sampled_durations = build_duration_map(self.tasks, sample_duration)
            _, makespan = ssgs_decode(priority_list, self.tasks, self.res_cap, sampled_durations)
            sampled_makespans.append(makespan)
        return sum(sampled_makespans) / len(sampled_makespans)

    def evaluate_parallel_samples(self, priority_list):
        if self.worker_count <= 1 or self.sample_count <= 1:
            return self.evaluate(priority_list)

        seed_base = random.randrange(1_000_000_000)
        jobs = [
            (priority_list, self.tasks, self.res_cap, seed_base + sample_idx)
            for sample_idx in range(self.sample_count)
        ]
        with ProcessPoolExecutor(max_workers=min(self.worker_count, self.sample_count)) as executor:
            sampled_makespans = list(executor.map(run_single_sample, jobs))
        return sum(sampled_makespans) / len(sampled_makespans)

    def deterministic_schedule(self, priority_list):
        durations = build_duration_map(self.tasks, resolve_deterministic_duration)
        return ssgs_decode(priority_list, self.tasks, self.res_cap, durations)


class GeneticAlgorithm:
    def __init__(self, tasks, all_ids, res_cap, pop_size=50, gens=100, sample_count=100, worker_count=None):
        self.tasks = tasks
        self.all_ids = all_ids
        self.res_cap = res_cap
        self.pop_size = pop_size
        self.gens = gens
        self.sample_count = max(1, sample_count)
        self.worker_count = max(1, worker_count or default_worker_count())
        self.evaluator = SequenceEvaluator(tasks, res_cap, sample_count, self.worker_count)

    def init_population(self):
        population = []
        for _ in range(self.pop_size):
            individual = list(self.all_ids)
            random.shuffle(individual)
            population.append(individual)
        return population

    def selection(self, population, fitness):
        idx1 = random.randint(0, len(population) - 1)
        idx2 = random.randint(0, len(population) - 1)
        return population[idx1] if fitness[idx1] > fitness[idx2] else population[idx2]

    def crossover(self, parent1, parent2):
        start = random.randint(0, len(parent1) - 1)
        end = random.randint(start, len(parent1) - 1)
        child = [None] * len(parent1)
        child[start : end + 1] = parent1[start : end + 1]

        parent2_idx = 0
        for i, value in enumerate(child):
            if value is None:
                while parent2[parent2_idx] in child:
                    parent2_idx += 1
                child[i] = parent2[parent2_idx]
        return child

    def mutate(self, chromosome):
        if random.random() < 0.1:
            idx1 = random.randint(0, len(chromosome) - 1)
            idx2 = random.randint(0, len(chromosome) - 1)
            chromosome[idx1], chromosome[idx2] = chromosome[idx2], chromosome[idx1]
        return chromosome

    def run(self):
        population = self.init_population()
        best_chromosome = None
        min_makespan = float("inf")
        history = []

        for generation in range(self.gens):
            if self.worker_count > 1 and len(population) > 1:
                seed_base = random.randrange(1_000_000_000)
                jobs = [
                    (individual, self.tasks, self.res_cap, self.sample_count, seed_base + index * self.sample_count)
                    for index, individual in enumerate(population)
                ]
                with ProcessPoolExecutor(max_workers=min(self.worker_count, len(population))) as executor:
                    makespans = list(executor.map(run_sequence_samples, jobs))
            else:
                makespans = [self.evaluator.evaluate(individual) for individual in population]
            fitness = [1.0 / makespan if makespan > 0 else 0 for makespan in makespans]

            current_min = min(makespans)
            if current_min < min_makespan:
                min_makespan = current_min
                best_chromosome = list(population[makespans.index(current_min)])

            history.append({"gen": generation + 1, "bestMs": round(min_makespan, 2)})

            new_population = [list(best_chromosome)]
            while len(new_population) < self.pop_size:
                parent1 = self.selection(population, fitness)
                parent2 = self.selection(population, fitness)
                child = self.crossover(parent1, parent2)
                child = self.mutate(child)
                new_population.append(child)
            population = new_population

        scheduled, _ = self.evaluator.deterministic_schedule(best_chromosome)
        return scheduled, round(min_makespan, 2), history


class SimulatedAnnealing:
    def __init__(self, tasks, all_ids, res_cap, gens=100, sample_count=100, worker_count=None):
        self.tasks = tasks
        self.all_ids = all_ids
        self.res_cap = res_cap
        self.gens = gens
        self.evaluator = SequenceEvaluator(tasks, res_cap, sample_count, worker_count)

    def run(self):
        current_chromosome = list(self.all_ids)
        random.shuffle(current_chromosome)
        current_makespan = self.evaluator.evaluate_parallel_samples(current_chromosome)

        best_chromosome = list(current_chromosome)
        best_makespan = current_makespan
        temperature = 100.0
        cooling_rate = 0.95
        history = []

        for generation in range(self.gens):
            neighbor = list(current_chromosome)
            idx1 = random.randint(0, len(neighbor) - 1)
            idx2 = random.randint(0, len(neighbor) - 1)
            neighbor[idx1], neighbor[idx2] = neighbor[idx2], neighbor[idx1]

            neighbor_makespan = self.evaluator.evaluate_parallel_samples(neighbor)

            if neighbor_makespan < current_makespan:
                accept_neighbor = True
            else:
                delta = current_makespan - neighbor_makespan
                accept_neighbor = random.random() < math.exp(delta / temperature)

            if accept_neighbor:
                current_chromosome = neighbor
                current_makespan = neighbor_makespan
                if current_makespan < best_makespan:
                    best_makespan = current_makespan
                    best_chromosome = list(current_chromosome)

            temperature *= cooling_rate
            history.append({"gen": generation + 1, "bestMs": round(best_makespan, 2)})

        scheduled, _ = self.evaluator.deterministic_schedule(best_chromosome)
        return scheduled, round(best_makespan, 2), history


def run_single_sample(job):
    priority_list, tasks, res_cap, seed = job
    sampled_durations = build_sampled_duration_map(tasks, seed)
    _, makespan = ssgs_decode(priority_list, tasks, res_cap, sampled_durations)
    return makespan


def run_sequence_samples(job):
    priority_list, tasks, res_cap, sample_count, seed_base = job
    sampled_makespans = []
    for offset in range(sample_count):
        sampled_durations = build_sampled_duration_map(tasks, seed_base + offset)
        _, makespan = ssgs_decode(priority_list, tasks, res_cap, sampled_durations)
        sampled_makespans.append(makespan)
    return sum(sampled_makespans) / len(sampled_makespans)
