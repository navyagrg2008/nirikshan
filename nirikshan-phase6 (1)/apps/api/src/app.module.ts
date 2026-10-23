import { MiddlewareConsumer, Module, NestModule, OnModuleInit } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ENV, loadEnv } from './config/env';
import { CryptoService } from './infra/crypto';
import { DbService } from './infra/db.service';
import { RedisService } from './infra/redis.service';
import { StorageService } from './infra/storage';
import { ScanService } from './infra/scan';
import { InspectionController } from './modules/inspection/inspection.controller';
import { InspectionService } from './modules/inspection/inspection.service';
import { DecisionsController } from './modules/decisions/decisions.controller';
import { DecisionsService } from './modules/decisions/decisions.service';
import { CertificatesController } from './modules/certificates/certificates.controller';
import { CertificatesService } from './modules/certificates/certificates.service';
import { CaptchaService, MessageProvider } from './infra/providers';
import { AuthGuard, CsrfGuard, IdempotencyInterceptor, RateLimitGuard, RolesGuard } from './common/guards';
import { ProblemFilter } from './common/filter';
import { RequestContextMiddleware } from './common/middleware';
import { AuditService } from './modules/audit/audit.service';
import { NotificationService } from './modules/notifications/notification.service';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { PasswordService } from './modules/auth/password.service';
import { OtpService } from './modules/auth/otp.service';
import { SessionService } from './modules/auth/session.service';
import { AuthService } from './modules/auth/auth.service';
import { AuthController, MeController } from './modules/auth/auth.controller';
import { InstrumentsService } from './modules/instruments/instruments.service';
import { InstrumentsController } from './modules/instruments/instruments.controller';
import { CatalogController } from './modules/catalog/catalog.controller';
import { PublicController } from './modules/public/public.controller';
import { HealthController } from './modules/health/health.controller';
import { FilesController } from './modules/files/files.controller';
import { OfficerService } from './modules/officer/officer.service';
import { OfficerController } from './modules/officer/officer.controller';
import { AdminService } from './modules/admin/admin.service';
import { MasterdataService } from './modules/admin/masterdata.service';
import { AdminController } from './modules/admin/admin.controller';
import { CaseStateService } from './modules/applications/case-state.service';
import { ApplicationsService } from './modules/applications/applications.service';
import { ApplicationsController } from './modules/applications/applications.controller';
import { SchedulingService } from './modules/scheduling/scheduling.service';
import { CasesService } from './modules/cases/cases.service';
import { CasesController } from './modules/cases/cases.controller';
import { SettingsService } from './modules/system/settings.service';
import { RequestsController } from './modules/requests/requests.controller';
import { RequestsService } from './modules/requests/requests.service';
import { ComplaintsController } from './modules/complaints/complaints.controller';
import { ComplaintsService } from './modules/complaints/complaints.service';
import { EnforcementController } from './modules/enforcement/enforcement.controller';
import { EnforcementService } from './modules/enforcement/enforcement.service';
import { RulesController } from './modules/rules/rules.controller';
import { RulesService } from './modules/rules/rules.service';
import { PrivacyController } from './modules/privacy/privacy.controller';
import { PrivacyService } from './modules/privacy/privacy.service';
import { MigrationController } from './modules/migration/migration.controller';
import { MigrationService } from './modules/migration/migration.service';
import { ReportsController } from './modules/reports/reports.controller';
import { ReportsService } from './modules/reports/reports.service';
import { DashboardService } from './modules/reports/dashboard.service';
import { SystemController } from './modules/system/system.controller';
import { LifecycleService } from './modules/jobs/lifecycle.service';
import { JobsService } from './modules/jobs/jobs.service';

@Module({
  controllers: [SystemController, ReportsController, MigrationController, PrivacyController, RulesController, EnforcementController, ComplaintsController, RequestsController, AuthController, MeController, InstrumentsController, CatalogController, PublicController, HealthController, FilesController, OfficerController, AdminController, NotificationsController, ApplicationsController, CasesController, InspectionController, DecisionsController, CertificatesController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    { provide: CryptoService, inject: [ENV], useFactory: (e: ReturnType<typeof loadEnv>) => new CryptoService(e.rootKeys, e.activeKeyId) },
    DbService, RedisService, StorageService, ScanService, MessageProvider, CaptchaService,
    AuditService, NotificationService, PasswordService, OtpService, SessionService, AuthService, InstrumentsService, OfficerService, AdminService, MasterdataService, SettingsService, ReportsService, DashboardService, MigrationService, PrivacyService, RulesService, EnforcementService, ComplaintsService, RequestsService, LifecycleService, JobsService, CaseStateService, ApplicationsService, SchedulingService, CasesService, InspectionService, DecisionsService, CertificatesService,
    // Order matters: authenticate, then CSRF, then role/permission, then rate limit.
    { provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_GUARD, useClass: CsrfGuard }, { provide: APP_GUARD, useClass: RolesGuard }, { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
  exports: [MessageProvider, DbService, CryptoService, RedisService],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(private db: DbService) {}
  async onModuleInit() { await this.db.init(); }
  configure(c: MiddlewareConsumer) { c.apply(RequestContextMiddleware).forRoutes('*'); }
}
