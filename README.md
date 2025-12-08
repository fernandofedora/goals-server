# API del Proyecto (goals-server)

API REST para gestionar categorías, tarjetas, transacciones, presupuestos y estadísticas. Construida con Node.js, Express y Sequelize sobre MySQL.

## Requisitos
- Node.js 18 o 20 (recomendado)
- MySQL 8.x (o compatible)
- npm o yarn

## Instalación
1. Clona el repositorio y entra al directorio `goals-server`.
2. Instala dependencias:
   - `npm install` o `yarn install`

## Configuración (.env)
Crear un archivo `.env` en `goals-server/` con las variables:

```
# Base de datos (puedes usar prefijos MYSQL* o DB_* )
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=pg-system
DB_USER=root
DB_PASSWORD=tu_password

# JWT
SECRET_KEY=un_secret_seguro

# Server
PORT=4000
```

Notas:
- El código soporta tanto variables con prefijo `MYSQL*` (común en proveedores administrados) como `DB_*`.
- `SECRET_KEY` es obligatorio para generar y validar JWT.

## Base de datos
Inicializa el esquema con el script SQL incluido:

```
mysql -u root -p < sql/create_pg-system.sql
```

El script crea la base `pg-system` y las tablas (`Users`, `Categories`, `Cards`, `Transactions`, `Budgets`) con índices y claves foráneas compatibles con Sequelize.

## Ejecutar en desarrollo
- `npm run dev` (usa nodemon)
- El servidor arranca en `http://localhost:4000` por defecto.

## Ejecutar en producción
- `npm start`
- Asegura Node 18+ (ideal 20) y que `.env` esté configurado.

## Endpoints principales
Base path: `/api`

Autenticación (`/api/auth`):
- `POST /auth/register` → `{ name, email, password }`
- `POST /auth/login` → `{ email, password }` → `{ token, user }`
- `POST /auth/reset-start` → `{ email }` → `{ exists: boolean }`
- `POST /auth/reset` → `{ email, password }`

Categorías (`/api/categories`) [JWT]:
- `GET /` lista
- `POST /` crea
- `PUT /:id` actualiza
- `DELETE /:id` elimina

Tarjetas (`/api/cards`) [JWT]:
- `GET /` lista
- `POST /` crea
- `PUT /:id` actualiza
- `DELETE /:id` elimina

Transacciones (`/api/transactions`) [JWT]:
- `GET /` lista (incluye categoría/tarjeta), ordenadas por fecha DESC
- `POST /` crea `{ type, description, amount, date, paymentMethod, categoryId?, cardId? }`
- `PUT /:id` actualiza
- `DELETE /:id` elimina

Presupuestos (`/api/budgets`) [JWT]:
- CRUD típico; se usa para “Budget vs Actual” por mes y año.

Estadísticas (`/api/stats`) [JWT]:
- `GET /summary?period=all|YYYY-MM` → Totales, categorías, timeseries diario, métodos de pago, por tarjeta y presupuesto del mes.
- `GET /export?period=all|YYYY-MM` → Archivo XLSX con hojas: Transactions, Overview, IncomeVsExpenses (mensual), Categories, PerCard y Budget.

Autorización
- Todas las rutas (excepto `/auth/*`) requieren header `Authorization: Bearer <token>`.

## Ejemplos rápidos
Login:
```
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"demo"}'
```

Resumen del mes:
```
curl -H "Authorization: Bearer <token>" \
  "http://localhost:4000/api/stats/summary?period=2025-03"
```

Export XLSX del mes:
```
curl -H "Authorization: Bearer <token>" \
  -OJ "http://localhost:4000/api/stats/export?period=2025-03"
```

## CORS
Se habilita `cors()` por defecto. Ajusta orígenes permitidos si lo necesitas en despliegues restrictivos.

## Resolución de problemas
- Node < 18 puede causar fallos de build o ejecución.
- Revisa credenciales de MySQL y que el host/puerto sean accesibles.
- Si usas proveedores administrados (p. ej. PlanetScale/Zeabur), usa variables `MYSQLHOST`, `MYSQLPORT`, `MYSQLDATABASE`, `MYSQLUSER`, `MYSQLPASSWORD`.

