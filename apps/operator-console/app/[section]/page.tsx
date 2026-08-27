import { ConsoleSection } from '../components';
export default async function Page({params}:{params:Promise<{section:string}>}){return <ConsoleSection section={(await params).section}/>;}
export function generateStaticParams(){return ['dashboard','projects','delivery','tasks','runs','validation','api-explorer','database','infrastructure','artifacts','audit','capabilities','settings'].map(section=>({section}));}
