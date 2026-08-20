import { ConsoleSection } from '../components';
export default async function Page({params}:{params:Promise<{section:string}>}){return <ConsoleSection section={(await params).section}/>;}
