import { FairShiftBrand } from "@/app/components/product-shell";

// The narrow, single-task frame shared by sign-in and the early onboarding steps.
export function AuthShell({ title, progress, children }: { title: string; progress?: React.ReactNode; children: React.ReactNode }) {
  return <main className="auth-shell">
    <FairShiftBrand />
    {progress}
    <div className="auth-card"><h1>{title}</h1>{children}</div>
  </main>;
}
