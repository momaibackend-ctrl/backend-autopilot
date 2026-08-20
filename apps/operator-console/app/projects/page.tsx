"use client";
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ProjectDetail } from '../components';
export default function Page(){return <Suspense fallback={<p>Loading project…</p>}><ProjectQuery/></Suspense>;}
function ProjectQuery(){const id=useSearchParams().get('projectId');return id?<ProjectDetail projectId={id}/>:<p>Select a project from the dashboard.</p>;}
