import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './styles.css';
import { AuthGate } from './auth-gate';
import { ConsoleNavigation } from './console-navigation';

export const metadata:Metadata={title:'Backend Autopilot Console',description:'Operator visibility and validation for Backend Autopilot'};
export default function Layout({children}:{children:ReactNode}){return <html lang="ru"><body><AuthGate><div className="shell"><aside><Link href="/dashboard" className="brand"><span className="brandMark">BA</span><span>Backend Autopilot<small>Operator Console · v0.5 remote</small></span></Link><ConsoleNavigation/><div className="safety"><span className="dot ok"/>Production actions disabled</div></aside><main><header><div><p className="eyebrow">REMOTE CONTROL PLANE</p><h1>Operator Console</h1></div><div className="live"><span className="pulse"/>Supabase · polling 5s</div></header>{children}</main></div></AuthGate></body></html>}
