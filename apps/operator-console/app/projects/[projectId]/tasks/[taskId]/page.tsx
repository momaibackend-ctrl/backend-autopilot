import { TaskDetail } from '../../../../components';
export default async function Page({params}:{params:Promise<{projectId:string;taskId:string}>}){const value=await params;return <TaskDetail projectId={value.projectId} taskId={value.taskId}/>;}
