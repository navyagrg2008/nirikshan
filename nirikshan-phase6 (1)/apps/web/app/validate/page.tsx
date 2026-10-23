'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ValidateView } from '@/components/ValidateView';
import { Loading } from '@/components/ui';
function Inner() { const q = useSearchParams(); return <ValidateView initialCert={q.get('cert') ?? undefined} />; }
export default function Page() { return <Suspense fallback={<Loading />}><Inner /></Suspense>; }
