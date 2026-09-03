import StorefrontShell from "@/components/storefront-shell";
// This layout survives navigation between catalog and all product detail routes.
export default function StorefrontLayout({ children }: { children: React.ReactNode }) {
  return <StorefrontShell>{children}</StorefrontShell>;
}
