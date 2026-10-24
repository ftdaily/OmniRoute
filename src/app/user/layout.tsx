import { SectionI18nProvider } from "@/i18n/SectionI18nProvider";

/**
 * Scoped user-portal i18n scope (p9-owned).
 * Root layout serves root namespaces only; /user pages use `userPortal`
 * (+ `common` for shared Input), so re-scope here without touching the
 * generated map or global catalog.
 */
export default function UserPortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionI18nProvider namespaces={["userPortal", "common"]}>
      {children}
    </SectionI18nProvider>
  );
}
