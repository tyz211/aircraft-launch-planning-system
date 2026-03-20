import React from 'react';
import { Task } from '../lib/ga';

interface GanttChartProps {
  scheduled: Record<string, [number, number]>;
  tasks: Record<string, Task>;
  makespan: number;
  numPlanes: number;
}

const COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
  '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
  '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5'
];

export const GanttChart: React.FC<GanttChartProps> = ({ scheduled, tasks, makespan, numPlanes }) => {
  const ROW_HEIGHT = 60;
  const HEADER_HEIGHT = 40;
  const chartHeight = numPlanes * ROW_HEIGHT + HEADER_HEIGHT;

  const ticks = [];
  for (let i = 0; i <= makespan; i += Math.ceil(makespan / 20)) {
    ticks.push(i);
  }
  if (ticks[ticks.length - 1] !== makespan) {
    ticks.push(makespan);
  }

  return (
    <div className="w-full overflow-x-auto bg-white rounded-xl shadow-sm border border-slate-200 p-4">
      <div className="relative min-w-[800px]" style={{ height: chartHeight }}>
        {/* X-axis ticks */}
        <div className="absolute top-0 left-12 right-0 h-10 border-b border-slate-200">
          {ticks.map(tick => (
            <div
              key={tick}
              className="absolute top-0 bottom-0 border-l border-slate-200 flex flex-col justify-end pb-1"
              style={{ left: `${(tick / makespan) * 100}%` }}
            >
              <span className="text-xs text-slate-500 -ml-2">{tick}</span>
            </div>
          ))}
        </div>

        {/* Y-axis labels and grid lines */}
        {Array.from({ length: numPlanes }).map((_, i) => (
          <div
            key={i}
            className="absolute left-0 right-0 border-b border-slate-100 flex items-center"
            style={{ top: HEADER_HEIGHT + i * ROW_HEIGHT, height: ROW_HEIGHT }}
          >
            <div className="w-12 text-sm font-medium text-slate-600 text-center">
              A{i + 1}
            </div>
            <div className="flex-1 h-full relative border-l border-slate-200">
              {/* Grid lines */}
              {ticks.map(tick => (
                <div
                  key={tick}
                  className="absolute top-0 bottom-0 border-l border-slate-100"
                  style={{ left: `${(tick / makespan) * 100}%` }}
                />
              ))}
            </div>
          </div>
        ))}

        {/* Task Bars */}
        <div className="absolute top-[40px] left-12 right-0 bottom-0">
          {Object.keys(scheduled).map(tid => {
            const [start, end] = scheduled[tid];
            const task = tasks[tid];
            const planeIdx = task.plane_id - 1;
            const color = COLORS[planeIdx % COLORS.length];
            
            let top = planeIdx * ROW_HEIGHT + 10;
            let height = 40;
            let fontSize = '0.75rem';

            if (task.type === 'F3') {
              top = planeIdx * ROW_HEIGHT + 5;
              height = 20;
              fontSize = '0.65rem';
            } else if (task.type === 'F4') {
              top = planeIdx * ROW_HEIGHT + 35;
              height = 20;
              fontSize = '0.65rem';
            }

            const left = (start / makespan) * 100;
            const width = ((end - start) / makespan) * 100;

            return (
              <div
                key={tid}
                className="absolute rounded-sm border border-black/20 flex items-center justify-center text-white font-bold shadow-sm hover:brightness-110 transition-all cursor-pointer group"
                style={{
                  top: `${top}px`,
                  height: `${height}px`,
                  left: `${left}%`,
                  width: `${width}%`,
                  backgroundColor: color,
                  fontSize
                }}
              >
                {task.type}
                
                {/* Tooltip */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 w-48 bg-slate-800 text-white text-xs rounded p-2 shadow-xl pointer-events-none">
                  <div className="font-bold mb-1">{task.id} ({task.name})</div>
                  <div>开始: {start} | 结束: {end}</div>
                  <div>持续时间: {task.duration}</div>
                  <div className="mt-1 pt-1 border-t border-slate-600">
                    {Object.entries(task.resources).map(([res, amt]) => (
                      <div key={res}>{res}: {amt}</div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
