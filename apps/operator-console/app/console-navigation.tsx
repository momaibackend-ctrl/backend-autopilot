"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authorizedFetch } from "./lib/supabase";

type Screen={screenId:string;navigationLabel:string;enabled:boolean;navigationOrder:number};
const fallback:Screen[]=["dashboard","projects","tasks","runs","validation","api-explorer","database","infrastructure","artifacts","audit","capabilities","settings"].map((screenId,index)=>({screenId,navigationLabel:title(screenId),enabled:true,navigationOrder:(index+1)*10}));
export function ConsoleNavigation(){const [screens,setScreens]=useState(fallback);useEffect(()=>{void authorizedFetch('/v1/console/screens').then(async response=>{if(response.ok){const value=await response.json() as Screen[];setScreens(value.filter(item=>item.enabled).sort((a,b)=>a.navigationOrder-b.navigationOrder));}}).catch(()=>undefined);},[]);return <nav>{screens.map(screen=><Link key={screen.screenId} href={`/${screen.screenId}`}>{screen.navigationLabel}</Link>)}</nav>;}
function title(value:string){return value.split('-').map(part=>part[0]?.toUpperCase()+part.slice(1)).join(' ');}
