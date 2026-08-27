"use client";
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ConsoleSection, TaskDetail } from '../components';
// Same dual role as app/projects/page.tsx: detail when both ids are present, otherwise the list.
export default function Page(){return <Suspense fallback={<p>Loading task…</p>}><TaskQuery/></Suspense>;}
function TaskQuery(){const query=useSearchParams(),projectId=query.get('projectId'),taskId=query.get('taskId');return projectId&&taskId?<TaskDetail projectId={projectId} taskId={taskId}/>:<ConsoleSection section="tasks"/>;}
