import type { Metadata } from "next";
import { ContactsView } from "@/components/ContactsView";

export const metadata: Metadata = { title: "Contacts" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <ContactsView initialBatchId={one(sp.batchId)} initialStatus={one(sp.status)} />;
}
