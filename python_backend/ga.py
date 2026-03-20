import math
import random


DEFAULT_WORKFLOW = [
    {
        "id": "F1",
        "name": "接收检查",
        "duration": 2,
        "resources": {"机务人员": 2},
        "predecessors": [],
    },
    {
        "id": "F2",
        "name": "燃油加注",
        "duration": 4,
        "resources": {"加油车": 1, "机务人员": 1},
        "predecessors": ["F1"],
    },
    {
        "id": "F3",
        "name": "挂弹作业",
        "duration": 2,
        "resources": {"挂弹车": 1, "军械人员": 2},
        "predecessors": ["F1"],
    },
    {
        "id": "F4",
        "name": "航电检查",
        "duration": 2,
        "resources": {"航电人员": 1, "测试仪": 1},
        "predecessors": ["F1"],
    },
    {
        "id": "F5",
        "name": "综合测试",
        "duration": 3,
        "resources": {"机务人员": 1, "航电人员": 1},
        "predecessors": ["F2", "F3", "F4"],
    },
    {
        "id": "F6",
        "name": "最终确认",
        "duration": 1,
        "resources": {"特设人员": 1},
        "predecessors": ["F5"],
    },
    {
        "id": "F7",
        "name": "发动机试车",
        "duration": 2,
        "resources": {"机务人员": 2},
        "predecessors": ["F6"],
    },
    {
        "id": "F8",
        "name": "放飞指令",
        "duration": 1,
        "resources": {},
        "predecessors": ["F7"],
    },
]


class Task:
    def __init__(self, id, plane_id, type, name, duration, resources, predecessors):
        self.id = id
        self.plane_id = plane_id
        self.type = type
        self.name = name
        self.duration = duration
        self.resources = resources
        self.predecessors = predecessors


def ssgs_decode(priority_list, tasks, res_cap):
    scheduled = {}
    completed = set()
    res_usage = []
    priority_positions = {tid: idx for idx, tid in enumerate(priority_list)}

    def get_usage(t):
        while len(res_usage) <= t:
            res_usage.append({k: 0 for k in res_cap})
        return res_usage[t]

    eligible = [tid for tid, task in tasks.items() if not task.predecessors]

    while eligible:
        curr_tid = min(eligible, key=lambda tid: priority_positions.get(tid, float("inf")))
        eligible.remove(curr_tid)
        task = tasks[curr_tid]

        est = 0
        for predecessor in task.predecessors:
            if predecessor in scheduled:
                est = max(est, scheduled[predecessor][1])

        start_time = est
        while True:
            can_schedule = True
            for t in range(start_time, start_time + task.duration):
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

        for t in range(start_time, start_time + task.duration):
            usage = get_usage(t)
            for res, amt in task.resources.items():
                usage[res] = usage.get(res, 0) + amt

        scheduled[curr_tid] = [start_time, start_time + task.duration]
        completed.add(curr_tid)

        for tid, task_obj in tasks.items():
            if tid not in completed and tid not in eligible:
                if all(pred in completed for pred in task_obj.predecessors):
                    eligible.append(tid)

    makespan = max((end for _, end in scheduled.values()), default=0)
    return scheduled, makespan


class GeneticAlgorithm:
    def __init__(self, tasks, all_ids, res_cap, pop_size=50, gens=100):
        self.tasks = tasks
        self.all_ids = all_ids
        self.res_cap = res_cap
        self.pop_size = pop_size
        self.gens = gens

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
            results = [ssgs_decode(individual, self.tasks, self.res_cap) for individual in population]
            makespans = [result[1] for result in results]
            fitness = [1.0 / makespan if makespan > 0 else 0 for makespan in makespans]

            current_min = min(makespans)
            if current_min < min_makespan:
                min_makespan = current_min
                best_chromosome = list(population[makespans.index(current_min)])

            history.append({"gen": generation + 1, "bestMs": min_makespan})

            new_population = [list(best_chromosome)]
            while len(new_population) < self.pop_size:
                parent1 = self.selection(population, fitness)
                parent2 = self.selection(population, fitness)
                child = self.crossover(parent1, parent2)
                child = self.mutate(child)
                new_population.append(child)
            population = new_population

        scheduled, makespan = ssgs_decode(best_chromosome, self.tasks, self.res_cap)
        return scheduled, makespan, history


class SimulatedAnnealing:
    def __init__(self, tasks, all_ids, res_cap, gens=100):
        self.tasks = tasks
        self.all_ids = all_ids
        self.res_cap = res_cap
        self.gens = gens

    def run(self):
        current_chromosome = list(self.all_ids)
        random.shuffle(current_chromosome)
        _, current_makespan = ssgs_decode(current_chromosome, self.tasks, self.res_cap)

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

            _, neighbor_makespan = ssgs_decode(neighbor, self.tasks, self.res_cap)

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
            history.append({"gen": generation + 1, "bestMs": best_makespan})

        scheduled, makespan = ssgs_decode(best_chromosome, self.tasks, self.res_cap)
        return scheduled, makespan, history


class GreedyAlgorithm:
    def __init__(self, tasks, all_ids, res_cap):
        self.tasks = tasks
        self.all_ids = all_ids
        self.res_cap = res_cap

    def run(self):
        priority_list = sorted(self.all_ids, key=lambda tid: (self.tasks[tid].plane_id, self.tasks[tid].type))
        scheduled, makespan = ssgs_decode(priority_list, self.tasks, self.res_cap)
        return scheduled, makespan, [{"gen": 1, "bestMs": makespan}]
