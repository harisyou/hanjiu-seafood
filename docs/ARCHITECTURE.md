# Haris OS Architecture

## System flow

```text
Frontend
   ↓
API
   ↓
Supabase
   ↓
Storage
```

The system should remain simple enough for daily operations while keeping
security and business rules at trustworthy boundaries.

## Layer responsibilities

### Frontend

The Next.js frontend provides customer and administrative interfaces. It is
responsible for presentation, interaction, form validation, loading and error
states, and mobile-first workflows. It must not contain privileged credentials
or be the only place where critical business rules are enforced.

### API

The API boundary coordinates trusted operations between the frontend and data
services. Depending on the feature, this can be a Next.js server action, route
handler, or a carefully scoped Supabase client operation protected by RLS. It
validates inputs, applies business rules, checks authorization, and returns
stable responses.

### Supabase

Supabase is the system of record for products, variants, customers, carts when
persisted, orders, and operational data. PostgreSQL constraints protect data
integrity. Authentication identifies administrators and users. Row Level
Security controls access independently of the UI.

### Storage

Supabase Storage holds product photography and future business files. Storage
policies control reads and writes. Database rows store stable object references
or public URLs rather than raw file data. Replacing an asset must not break
historical orders or unrelated products.

## Domain flow

```text
Products
   ↓
Variants
   ↓
Cart
   ↓
Orders
   ↓
Customers
```

### Products

Products contain shared merchandising information such as name, description,
photography, cooking guidance, visibility, and display order. Products are
retained rather than deleted because other records can reference them.

### Variants

Variants are the purchasable options of a product. They own price, availability,
inventory, display name, and ordering. A product may have multiple sizes,
weights, packages, or processing options.

### Cart

The cart captures customer intent before an order exists. Each line is tied to
a product and a selected variant and contains the price and quantity used during
checkout. The cart prevents unavailable variants from being ordered.

### Orders

Orders are permanent business records. They snapshot customer contact details,
fulfillment and processing choices, and order-item product and variant details.
Catalog changes must never rewrite an existing order.

### Customers

Customers represent the continuing business relationship across orders and
sales channels. Customer records are permanent and may later support CRM,
segmentation, service history, and follow-up workflows.

## Architectural direction

- Extend the current Next.js and Supabase architecture before adding services.
- Put durable business rules in database constraints, RLS, and trusted server
  boundaries.
- Keep user interfaces optimized for the seafood team’s daily workflow.
- Preserve identifiers and historical snapshots across catalog changes.
- Introduce new layers only when they solve a measured operational problem.
