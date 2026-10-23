'use client';
import { CertificateRegister } from '@/components/CertificateRegister';
import { PageTitle } from '@/components/ui';
import { useTr } from '@/lib/inspection';
export default function Page() { const { tr } = useTr(); return <div><PageTitle>{tr('Your certificates', 'आपके प्रमाणपत्र')}</PageTitle><CertificateRegister base="/owner/certificates" /></div>; }
