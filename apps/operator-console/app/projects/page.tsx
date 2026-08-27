"use client";
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ConsoleSection, ProjectDetail } from '../components';
// This static segment shadows app/[section]/page.tsx for /projects, so it has to serve BOTH views:
// without it the sidebar link rendered a dead "Select a project" line and the Projects list was
// unreachable. Query-string routing (rather than a [projectId] segment) is forced by
// next.config.ts `output:'export'` -- a static build cannot enumerate project ids at build time.
export default function Page(){return <Suspense fallback={<p>Loading project…</p>}><ProjectQuery/></Suspense>;}
function ProjectQuery(){const id=useSearchParams().get('projectId');return id?<ProjectDetail projectId={id}/>:<ConsoleSection section="projects"/>;}
