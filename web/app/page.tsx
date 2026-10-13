import { redirect } from "next/navigation";

// proxy.ts already routes "/" (dashboard when signed in, login otherwise); this is the fallback.
export default function Home() {
  redirect("/dashboard");
}
