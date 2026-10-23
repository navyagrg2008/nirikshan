'use client';
import { use } from 'react';
import { CertificateView } from '@/components/CertificateView';
export default function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = use(params); return <CertificateView id={id} back="/officer/certificates" staff />; }
