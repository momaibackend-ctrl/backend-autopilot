import type { NextConfig } from 'next';
const basePath=process.env['NEXT_PUBLIC_GITHUB_PAGES_BASE_PATH']??'';
const localDevelopment=process.env['NEXT_PUBLIC_AUTOPILOT_LOCAL_DEV']==='true';
const controlApiOrigin=process.env['AUTOPILOT_CONTROL_API_ORIGIN']??'http://127.0.0.1:4310';
const config:NextConfig=localDevelopment
  ? {reactStrictMode:true,async rewrites(){return [{source:'/api/control/:path*',destination:`${controlApiOrigin}/:path*`}];}}
  : {output:'export',distDir:'.next-static',trailingSlash:true,reactStrictMode:true,basePath,assetPrefix:basePath};
export default config;
