import { FairShiftBrand } from "@/app/components/product-shell";

// The narrow, single-task frame shared by sign-in and the early onboarding steps.
// aside and eyebrow are optional (design SignUp): a dark panel beside the card on wide screens, and a step line.
export function AuthShell({ title, progress, eyebrow, aside, children }: { title: string; progress?: React.ReactNode; eyebrow?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  const card = <div className="auth-card">{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h1>{title}</h1>{children}</div>;
  return <main className={aside ? "auth-shell auth-shell-split" : "auth-shell"}>
    <FairShiftBrand />
    {progress}
    {aside ? <div className="auth-split"><aside className="auth-aside">{aside}</aside>{card}</div> : card}
  </main>;
}
