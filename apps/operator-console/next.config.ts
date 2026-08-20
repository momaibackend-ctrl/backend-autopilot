import type { NextConfig } from 'next';
const config:NextConfig={reactStrictMode:true,async rewrites(){return [{source:'/api/control/:path*',destination:'http://127.0.0.1:4310/:path*'}];}};
export default config;
