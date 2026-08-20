import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata:Metadata={title:'Backend Autopilot Console',description:'Operator visibility and validation for Backend Autopilot'};
const sections=['Dashboard','Projects','Tasks','Runs','Validation','Infrastructure','Artifacts','Audit','Capabilities','Settings'];
export default function Layout({children}:{children:ReactNode}){return <html lang="ru"><body><div className="shell"><aside><Link href="/dashboard" className="brand"><span className="brandMark">BA</span><span>Backend Autopilot<small>Operator Console · v0.3</small></span></Link><nav>{sections.map(section=><Link key={section} href={`/${section.toLowerCase()}`}>{section}</Link>)}</nav><div className="safety"><span className="dot ok"/>Production actions disabled</div></aside><main><header><div><p className="eyebrow">CONTROL PLANE</p><h1>Operator Console</h1></div><div className="live"><span className="pulse"/>Live · polling 5s</div></header>{children}</main></div></body></html>}
