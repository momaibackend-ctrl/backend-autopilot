import { ProjectDetail } from '../../components';
export default async function Page({params}:{params:Promise<{projectId:string}>}){return <ProjectDetail projectId={(await params).projectId}/>;}
