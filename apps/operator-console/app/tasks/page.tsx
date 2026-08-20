"use client";
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { TaskDetail } from '../components';
export default function Page(){return <Suspense fallback={<p>Loading task…</p>}><TaskQuery/></Suspense>;}
function TaskQuery(){const query=useSearchParams(),projectId=query.get('projectId'),taskId=query.get('taskId');return projectId&&taskId?<TaskDetail projectId={projectId} taskId={taskId}/>:<p>Select a task from the dashboard.</p>;}
