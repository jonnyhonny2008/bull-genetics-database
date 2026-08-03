import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { isDemo } from "@/lib/env";
import { LoginExperience } from "./LoginExperience";

const DEMO_LOGINS = [
  { role: "Admin", email: "admin@studgenetics.local", pw: "Admin#12345" },
  { role: "Staff", email: "staff@studgenetics.local", pw: "Staff#12345" },
  { role: "Sales", email: "sales@studgenetics.local", pw: "Sales#12345" },
  { role: "Consultant", email: "consultant@studgenetics.local", pw: "Consult#12345" },
];

export default function LoginPage() {
  if (currentUser()) redirect("/dashboard");
  const demo = isDemo();
  // The demo credentials exist only in the demo environment, and are only ever
  // sent to the browser there.
  return <LoginExperience isDemo={demo} demoLogins={demo ? DEMO_LOGINS : []} />;
}
