import React, { useState, useEffect } from 'react';
import { Play, Pause, AlertTriangle, CheckCircle, Clock, Plane, Users, Zap, Wrench, Activity } from 'lucide-react';
import { Task, ResourceMap } from '../lib/ga';

interface DashboardProps {
  scheduled: Record<string, [number, number]>;
  tasks: Record<string, Task>;
  makespan: number;
  numPlanes: number;
  resources: ResourceMap;
}

export const Dashboard: React.FC<DashboardProps> = ({ scheduled, tasks, makespan, numPlanes, resources }) => {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isPlaying && currentTime < makespan) {
      interval = setInterval(() => {
        setCurrentTime(t => {
          if (t >= makespan) {
            setIsPlaying(false);
            return makespan;
          }
          return t + 1;
        });
      }, 200); // 200ms per minute for smoother playback
    }
    return () => clearInterval(interval);
  }, [isPlaying, currentTime, makespan]);

  // Calculate state at currentTime
  const activeTasks = Object.keys(scheduled).filter(tid => {
    const [start, end] = scheduled[tid];
    return currentTime >= start && currentTime < end;
  });
  
  // Resource usage
  const resourceUsage: Record<string, number> = {};
  for (const key in resources) resourceUsage[key] = 0;

  activeTasks.forEach(tid => {
    const task = tasks[tid];
    for (const [res, amt] of Object.entries(task.resources)) {
      resourceUsage[res] += amt as number;
    }
  });

  // Aircraft status
  const aircraftStatus = Array.from({ length: numPlanes }).map((_, i) => {
    const pid = i + 1;
    const planeTasks = Object.keys(tasks).filter(tid => tasks[tid].plane_id === pid);
    const planeCompleted = planeTasks.filter(tid => scheduled[tid][1] <= currentTime);
    const planeActive = planeTasks.filter(tid => scheduled[tid][0] <= currentTime && scheduled[tid][1] > currentTime);
    
    let status = '等待中';
    if (planeCompleted.length === planeTasks.length) status = '已完成';
    else if (planeActive.length > 0) status = '进行中';
    
    return {
      id: pid,
      status,
      activeTasks: planeActive,
      progress: (planeCompleted.length / planeTasks.length) * 100,
      completedCount: planeCompleted.length,
      totalCount: planeTasks.length
    };
  });

  // Alerts
  const alerts = [];
  for (const [res, cap] of Object.entries(resources)) {
    if (resourceUsage[res] === cap && (cap as number) > 0) {
      alerts.push(`${res} 已满载。`);
    }
  }

  return (
    <div className="space-y-6">
      {/* Control Bar */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center gap-6">
        <button 
          onClick={() => setIsPlaying(!isPlaying)}
          className={`p-3 rounded-full text-white transition-colors ${isPlaying ? 'bg-amber-500 hover:bg-amber-600' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
        </button>
        
        <div className="flex-1">
          <div className="flex justify-between text-sm font-medium text-slate-600 mb-2">
            <span>模拟时间: {currentTime} 分钟</span>
            <span>总完工时间: {makespan} 分钟</span>
          </div>
          <input 
            type="range" 
            min="0" 
            max={makespan} 
            value={currentTime}
            onChange={(e) => {
              setCurrentTime(Number(e.target.value));
              setIsPlaying(false);
            }}
            className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left Column: Resources & Alerts */}
        <div className="space-y-6">
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-500" /> 资源利用率
            </h3>
            <div className="space-y-4">
              {Object.entries(resources).map(([res, cap]) => {
                const used = resourceUsage[res] || 0;
                const percent = (cap as number) > 0 ? (used / (cap as number)) * 100 : 0;
                let color = 'bg-blue-500';
                if (percent >= 100) color = 'bg-red-500';
                else if (percent >= 80) color = 'bg-amber-500';

                let Icon = Users;
                if (res.includes('Car')) Icon = Zap;
                if (res.includes('Tester')) Icon = Wrench;

                return (
                  <div key={res}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-600 flex items-center gap-1">
                        <Icon className="w-3.5 h-3.5" />
                        {res}
                      </span>
                      <span className="font-medium text-slate-800">{used} / {cap as number}</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2">
                      <div className={`${color} h-2 rounded-full transition-all duration-300`} style={{ width: `${percent}%` }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {alerts.length > 0 && (
            <div className="bg-red-50 p-5 rounded-xl border border-red-100">
              <h3 className="text-sm font-bold text-red-800 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> 活动警报
              </h3>
              <ul className="space-y-2">
                {alerts.map((alert, idx) => (
                  <li key={idx} className="text-sm text-red-700 flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 mt-1.5 shrink-0"></span>
                    {alert}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Middle & Right Column: Aircraft Status */}
        <div className="xl:col-span-2 space-y-6">
          <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
            <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Plane className="w-5 h-5 text-blue-500" /> 飞机状态
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {aircraftStatus.map(plane => (
                <div key={plane.id} className="p-4 rounded-lg border border-slate-100 bg-slate-50 flex flex-col gap-3">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-slate-800 text-lg">A{plane.id}</span>
                    {plane.status === '已完成' && <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs font-bold rounded-full flex items-center gap-1"><CheckCircle className="w-3 h-3" /> 已完成</span>}
                    {plane.status === '进行中' && <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded-full flex items-center gap-1"><Activity className="w-3 h-3" /> 进行中</span>}
                    {plane.status === '等待中' && <span className="px-2 py-1 bg-slate-200 text-slate-600 text-xs font-bold rounded-full flex items-center gap-1"><Clock className="w-3 h-3" /> 等待中</span>}
                  </div>
                  
                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>进度</span>
                      <span>{plane.completedCount} / {plane.totalCount} 任务</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-1.5">
                      <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${plane.progress}%` }}></div>
                    </div>
                  </div>

                  <div className="text-sm">
                    <span className="text-slate-500">当前任务: </span>
                    {plane.activeTasks.length > 0 ? (
                      <span className="font-medium text-slate-800">
                        {plane.activeTasks.map(tid => `${tasks[tid].type} (${tasks[tid].name})`).join(', ')}
                      </span>
                    ) : (
                      <span className="text-slate-400 italic">无</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
