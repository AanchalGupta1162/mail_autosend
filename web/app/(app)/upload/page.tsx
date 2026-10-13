import type { Metadata } from "next";
import { UploadView } from "@/components/UploadView";

export const metadata: Metadata = { title: "Upload" };

export default function UploadPage() {
  return <UploadView />;
}
