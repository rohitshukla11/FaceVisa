"use client";

/** A spend over the brand workspace's limit: the brand approves or denies that exact amount in Likeness. */
import { useParams } from "next/navigation";
import { SpendPage } from "@/components/likeness/SpendPage";

export default function SpendById() {
  const { id } = useParams<{ id: string }>();
  return <SpendPage id={id} />;
}
