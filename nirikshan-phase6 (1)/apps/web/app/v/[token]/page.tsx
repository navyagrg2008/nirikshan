'use client';
import { use } from 'react';
import { ValidateView } from '@/components/ValidateView';
export default function Page({ params }: { params: Promise<{ token: string }> }) { const { token } = use(params); return <ValidateView token={decodeURIComponent(token)} />; }
