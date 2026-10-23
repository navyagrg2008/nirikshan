const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';
/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true, output: 'standalone', poweredByHeader: false, transpilePackages: ['@nirikshan/shared'],
  // The browser only ever talks to this origin. Cookies stay first-party and the API is never exposed directly (BFF pattern).
  async rewrites() { return [{ source: '/api/v1/:path*', destination: `${API}/api/v1/:path*` }]; },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' }, { key: 'X-Frame-Options', value: 'DENY' },
    ] }];
  },
};
