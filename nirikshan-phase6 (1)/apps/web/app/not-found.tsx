import Link from 'next/link';
export default function NotFound() { return <div className="py-16 text-center"><h1 className="text-2xl font-semibold">404</h1><p className="mt-2 text-muted">We could not find that page.</p><Link href="/" className="mt-6 inline-block rounded-lg bg-primary px-4 py-3 text-primary-ink">Home</Link></div>; }
