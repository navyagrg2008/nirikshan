import { PageTitle } from '@/components/ui';
export const metadata = { title: 'Privacy' };
export default function Page() {
  return <article className="prose-sm max-w-2xl space-y-4"><PageTitle>Privacy notice</PageTitle>
    <p className="rounded-lg border border-warn p-3 text-sm">Draft for a demonstration system. It must be reviewed by the department&apos;s legal team before real use.</p>
    <h2 className="text-lg font-semibold">What we collect</h2><p>Your name, date of birth, mobile number, optional email, business details, address, the last four characters of one ID proof, and documents you upload. We do not store a full ID number.</p>
    <h2 className="text-lg font-semibold">How we protect it</h2><p>Personal fields are encrypted one by one. Officers see masked values unless their role needs more, and every view of a document is recorded in an audit trail that cannot be edited.</p>
    <h2 className="text-lg font-semibold">Why we use it</h2><p>Only to run legal metrology verification: confirming who you are, registering instruments, scheduling inspections and issuing certificates. We do not sell or share it for any other purpose.</p>
    <h2 className="text-lg font-semibold">Your choices</h2><p>You can see your sessions, sign out everywhere, and change your password in Settings. Requests to correct or erase data can be sent through the Help page.</p>
    <h2 className="text-lg font-semibold">No fees</h2><p>This portal never asks for payment. Report anyone who does.</p></article>;
}
