# Haris OS AI Developer Guide

## Project overview

Haris OS is an operations system for a seafood business. It connects product
creation, social selling, customer communication, ordering, packing, and
delivery. It is not a generic ecommerce template.

AI developers must optimize the real daily workflow, preserve business data,
and extend the existing product before introducing new abstractions.

## Business goals

- Reduce the time between receiving seafood and publishing it for sale.
- Make product, variant, price, availability, and order information reliable.
- Support sales conversations across Facebook, LINE, and Threads.
- Make daily work fast on mobile devices.
- Preserve historical data for customer service, finance, and future analysis.

## Technology stack

- Next.js App Router
- React and TypeScript
- Supabase Database, Authentication, Row Level Security, and Storage
- CSS maintained in the existing application style system
- Git and GitHub for version control and review

## Development workflow

1. Always inspect the existing code, schema, configuration, and related flows
   before implementing.
2. Confirm the business workflow and acceptance criteria.
3. Extend the existing architecture instead of rewriting working features.
4. Implement the smallest complete change.
5. Test affected user and administrative flows.
6. Run lint and build before every Pull Request.
7. Review the final diff for unrelated or destructive changes.

Do not rewrite an existing subsystem solely to introduce a preferred library,
pattern, or framework. A rewrite requires an explicit business reason, a
migration plan, and approval.

## Coding standards

- Prefer clear, direct code over premature abstraction.
- Keep functions focused and name them after business actions.
- Reuse existing components, types, utilities, and visual patterns.
- Handle loading, empty, success, and error states.
- Never expose secrets or privileged Supabase credentials to the browser.
- Keep user-facing text in Traditional Chinese unless the product requires
  another language.
- Avoid unrelated formatting or refactoring in feature changes.

## TypeScript conventions

- Keep strict TypeScript enabled.
- Do not introduce `any`; use explicit types, generics, or `unknown` with
  validation.
- Define shared domain types in a stable shared module.
- Represent finite states with unions or enums rather than arbitrary strings.
- Treat database values as nullable when the schema permits null.
- Narrow errors before reading their properties.
- Do not silence type errors with unsafe assertions unless the boundary is
  verified and documented.

## Next.js conventions

- Use the App Router and preserve the existing route structure.
- Prefer Server Components by default; add `"use client"` only when browser
  APIs, state, effects, or event handlers are required.
- Keep secrets and privileged operations on the server.
- Handle prerendering and missing build-time environment variables safely.
- Use route-level loading and error states where they improve operations.
- Avoid adding a new state-management or styling system without a demonstrated
  need.

## Mobile-first principles

- Design for the smallest supported screen first.
- Use large touch targets and readable text.
- Keep primary actions visible and easy to reach.
- Avoid wide tables for daily operational tasks.
- Verify forms, uploads, product selection, cart, and order handling on mobile.
- Favor speed and clarity over decorative effects.

## Git conventions

### Branch naming

Never work directly on `main`. Use one branch per feature or concern:

- `feature/F001-short-description`
- `fix/F001-short-description`
- `docs/short-description`
- `chore/short-description`

### Commit messages

Use small, imperative commits with a clear scope. Conventional prefixes are
preferred:

- `feat: add variant selector`
- `fix: preserve order item price`
- `docs: initialize Haris OS engineering documentation`
- `chore: update build configuration`

Do not mix unrelated changes in one commit.

## Product Variant design rules

- A product describes the shared item; a variant describes the purchasable
  option, such as weight, size, processing, or package.
- Every purchasable variant has a stable ID, display name, price, availability,
  inventory state, and sort order.
- Customers must select a variant before adding a product to the cart.
- A cart item is identified by its variant, not only its product.
- Order items snapshot `product_id`, `variant_id`, `variant_name`, `price`, and
  `quantity` so later catalog changes do not alter order history.
- Unavailable variants remain in historical records and must not be deleted to
  hide them from sale.

## Inventory rules

- Exact inventory is operational data and is not shown to customers.
- Customer-facing states are `現貨充足`, `剩少量`, `最後1份`, and `已售完`.
- Inventory cannot be negative.
- Inventory changes must be traceable when inventory management is introduced.
- Never infer historical inventory from the current value.
- An unavailable variant cannot be added to a cart or new order.

## Pull Request checklist

- [ ] The change has one clear responsibility.
- [ ] The branch is based on the intended target branch.
- [ ] Existing code and related business flows were inspected first.
- [ ] The implementation extends rather than unnecessarily rewrites.
- [ ] Database changes include a safe migration and appropriate RLS policies.
- [ ] Upload, login, product, cart, order, and other affected flows still work.
- [ ] Mobile layout and touch interactions were checked.
- [ ] No secrets, generated files, or unrelated changes are included.
- [ ] Lint and production build pass.
- [ ] The PR explains deployment or migration steps.

## Testing checklist

- [ ] Happy path works from start to finish.
- [ ] Loading, empty, validation, error, and unavailable states are covered.
- [ ] Authentication and authorization boundaries are verified.
- [ ] Database writes preserve required IDs and historical snapshots.
- [ ] Mobile and desktop layouts are checked.
- [ ] Existing upload, login, product management, and order management regressions
      are checked when relevant.
- [ ] Lint passes when a lint script exists.
- [ ] Production build passes.

## Production readiness checklist

- [ ] Environment variables are documented and configured.
- [ ] Database migrations are repeatable and safe for existing data.
- [ ] RLS policies follow least privilege.
- [ ] Errors are understandable and do not leak sensitive information.
- [ ] Destructive actions require confirmation and preserve business history.
- [ ] Operational workflows remain usable on mobile and slow networks.
- [ ] Rollback or recovery steps are understood.
- [ ] Monitoring and ownership are identified for high-risk changes.
- [ ] Deployment notes and release changes are documented.
