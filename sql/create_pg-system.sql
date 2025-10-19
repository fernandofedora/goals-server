-- Script de creación de base de datos y esquema para el sistema
-- Dialecto: MySQL (compatibilidad con sequelize/mysql2)

-- 1) Crear base de datos
CREATE DATABASE IF NOT EXISTS `pg-system`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE `pg-system`;

-- 2) Tabla: Users (Sequelize: User -> tabla plural "Users")
CREATE TABLE IF NOT EXISTS `Users` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) Tabla: Categories (Sequelize: Category -> "Categories")
CREATE TABLE IF NOT EXISTS `Categories` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `color` VARCHAR(7) NOT NULL DEFAULT '#3b82f6',
  `type` ENUM('expense','income') NOT NULL,
  `UserId` INT NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_categories_user` (`UserId`),
  CONSTRAINT `fk_categories_user`
    FOREIGN KEY (`UserId`) REFERENCES `Users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Tabla: Cards (Sequelize: Card -> "Cards")
CREATE TABLE IF NOT EXISTS `Cards` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NOT NULL,
  `color` VARCHAR(7) NOT NULL DEFAULT '#0ea5e9',
  `last4` VARCHAR(4) NOT NULL,
  `UserId` INT NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cards_user` (`UserId`),
  CONSTRAINT `fk_cards_user`
    FOREIGN KEY (`UserId`) REFERENCES `Users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5) Tabla: Transactions (Sequelize: Transaction -> "Transactions")
CREATE TABLE IF NOT EXISTS `Transactions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `type` ENUM('expense','income') NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL,
  `date` DATE NOT NULL,
  `paymentMethod` ENUM('cash','card') NOT NULL,
  `UserId` INT NOT NULL,
  `CategoryId` INT NULL,
  `CardId` INT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_transactions_user` (`UserId`),
  KEY `idx_transactions_category` (`CategoryId`),
  KEY `idx_transactions_card` (`CardId`),
  KEY `idx_transactions_user_date` (`UserId`, `date`),
  CONSTRAINT `fk_transactions_user`
    FOREIGN KEY (`UserId`) REFERENCES `Users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_transactions_category`
    FOREIGN KEY (`CategoryId`) REFERENCES `Categories`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_transactions_card`
    FOREIGN KEY (`CardId`) REFERENCES `Cards`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6) Tabla: Budgets (Sequelize: Budget -> "Budgets")
CREATE TABLE IF NOT EXISTS `Budgets` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `month` INT NOT NULL,
  `year` INT NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL,
  `UserId` INT NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_budgets_user` (`UserId`),
  CONSTRAINT `fk_budgets_user`
    FOREIGN KEY (`UserId`) REFERENCES `Users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE KEY `uniq_budgets_user_month_year` (`UserId`, `month`, `year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notas:
-- - Las tablas usan nombres pluralizados como lo hace Sequelize por defecto.
-- - Se incluyen createdAt/updatedAt porque Sequelize los gestiona por defecto.
-- - ON DELETE CASCADE para referencias a UserId, y ON DELETE SET NULL para CategoryId/CardId en Transactions
--   para permitir borrar categorías/tarjetas sin perder transacciones.
-- - El índice único en Budgets (UserId, month, year) asegura un presupuesto por período y usuario, tal como
--   espera el código al usar findOne.