import Link from "next/link";
import { FairShiftBrand } from "@/app/components/product-shell";
export default function Home() {return <main className="entry-shell"><header className="entry-topbar"><FairShiftBrand/><Link href="/sign-in">Sign in</Link></header><h1>Plan work. Agree terms. Track earnings.</h1><p>Create your Owner identity to start an organisation, or join your team with an invitation.</p><p><Link className="primary-button button-link" href="/register">Get started</Link> <Link href="/invite">Redeem invitation</Link></p></main>;}
