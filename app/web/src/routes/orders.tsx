import { createFileRoute } from "@tanstack/react-router"
import { OrdersTable } from "@/components/orders/orders-table"

export const Route = createFileRoute("/orders")({
  component: OrdersPage,
})

function OrdersPage() {
  return <OrdersTable />
}
