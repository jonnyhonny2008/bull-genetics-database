import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { LoginExperience } from "./LoginExperience";

export default function LoginPage() {
  if (currentUser()) redirect("/dashboard");
  return <LoginExperience />;
}
