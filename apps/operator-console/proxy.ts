import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const challenge = { 'WWW-Authenticate': 'Basic realm="Backend Autopilot", charset="UTF-8"' };

export default function proxy(request:NextRequest) {
  if (process.env.NODE_ENV !== 'production') return NextResponse.next();
  const configured = process.env['AUTOPILOT_CONSOLE_BASIC_AUTH'];
  if (!configured) {
    return NextResponse.json(
      {error:{code:'CONFIGURATION_ERROR',message:'Operator access is not configured'}},
      {status:503},
    );
  }
  const expected = Buffer.from(`Basic ${Buffer.from(configured).toString('base64')}`);
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  if (expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) {
    return new NextResponse('Authentication required',{status:401,headers:challenge});
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api/control/health|_next/static|_next/image|favicon.ico).*)'],
};
