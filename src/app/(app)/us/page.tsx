import { redirect } from "next/navigation";

// Bare /us has no page of its own — send it to the American dashboard, mirroring
// how the Canadian side treats "/".
export default function UsIndexPage() {
  redirect("/us/dashboard");
}
