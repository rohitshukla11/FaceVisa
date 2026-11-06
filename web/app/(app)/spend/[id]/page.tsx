"use client";

/** A spend over the brand workspace's limit: the brand approves or denies that exact amount in FaceVisa. */
import { useParams } from "next/navigation";
import { SpendPage } from "@/components/facevisa/SpendPage";

export default function SpendById() {
  const { id } = useParams<{ id: string }>();
  return <SpendPage id={id} />;
}
