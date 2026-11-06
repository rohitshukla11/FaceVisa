"use client";

/** One licence request for the signed-in creator: the finished ad, then Approve, Reject or Deny in FaceVisa. */
import { useParams } from "next/navigation";
import { RequestPage } from "@/components/facevisa/RequestPage";

export default function RequestById() {
  const { id } = useParams<{ id: string }>();
  return <RequestPage id={id} />;
}
