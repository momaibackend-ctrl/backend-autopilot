import type { NextConfig } from 'next';
const controlApiOrigin = process.env['AUTOPILOT_CONTROL_API_ORIGIN'] ??
  (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:4310' : 'http://control-api:4310');

const config:NextConfig={
  reactStrictMode:true,
  async rewrites(){
    return [{source:'/api/control/:path*',destination:`${controlApiOrigin}/:path*`}];
  },
};
export default config;
