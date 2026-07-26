import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export default function Home() {
  redirect(currentUser() ? "/dashboard" : "/login");
}
