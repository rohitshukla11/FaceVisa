"use client";

/** Where a check without a request lands: the creator's requests live on the dashboard. */
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Requests() {
  const router = useRouter();
  useEffect(() => router.replace("/dashboard"), [router]);
  return null;
}
