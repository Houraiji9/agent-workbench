// 对话框路由：所有表单在打开时冻结版本号，实时刷新不会悄悄覆盖你正在填写的内容。
import React from 'react';
import {ReviewOrderDialog,ReviewReceiptDialog} from './dialogs/ReviewOrderDialog.js';
import { QuotaDialog,WorkBuddyPointsDialog } from './dialogs/QuotaDialog.js';
import { useStore } from '../app/store.js';
import { RequestDialog, ImportPlanDialog, ReceiptDialog, ReviewDialog, GrokReviewDialog, RevokeReviewDialog, AcceptDialog, RejectDialog, RetryDialog, CancelDialog, ArtifactDialog } from './dialogs/TaskDialogs.js';
import { RegisterProjectDialog, EditProjectDialog, ArchiveProjectDialog, AddPathDialog, MemoryDialog, DiagramDialog, AddRootDialog } from './dialogs/ProjectDialogs.js';
import { SubscriptionEditDialog, SubscriptionDeleteDialog, SubscriptionConfirmDialog, SessionDialog } from './dialogs/ResourceDialogs.js';
import {AgentManageDialog,QuotaManageDialog,RemoveResourceDialog} from './dialogs/ManagementDialogs.js';
import {RequestActionDialog,RequestHandoffDialog} from './dialogs/RequestDialog.js';
import {RequestContentDialog} from '../ui/RequestPreview.js';
import {OrderCopyDialog} from '../ui/TaskQuickActions.js';

export function Dialogs() {
  const s = useStore();
  const d = s.dialog;
  if (!d) return null;
  const p = d.props || {};
  const close = s.closeDialog;
  const key = d.name + ':' + JSON.stringify(Object.keys(p));
  switch (d.name) {
    case 'order-copy': return <OrderCopyDialog task={p.task} text={p.text} onClose={close}/>;
    case 'request-content': return <RequestContentDialog request={p.request} onClose={close}/>;
    case 'request-handoff': return <RequestHandoffDialog key={p.request.id} request={p.request} fallbackText={p.fallbackText} onClose={close}/>;
    case 'request-action': return <RequestActionDialog key={p.request.id+':'+p.action} request={p.request} action={p.action} onClose={close}/>;
    case 'request': return <RequestDialog key={key} projectId={p.projectId} request={p.request} onClose={close} />;
    case 'import-plan': return <ImportPlanDialog key={key} onClose={close} />;
    case 'receipt': return <ReceiptDialog key={key} onClose={close} />;
    case 'review-order': return <ReviewOrderDialog key={p.detail.task.id} detail={p.detail} onClose={close}/>;
    case 'review-receipt': return <ReviewReceiptDialog key={p.detail.task.id} detail={p.detail} onClose={close}/>;
    case 'review': return <ReviewDialog key={key} detail={p.detail} onClose={close} />;
    case 'grok-review': return <GrokReviewDialog key={p.detail.task.id} detail={p.detail} onClose={close} />;
    case 'revoke-review': return <RevokeReviewDialog key={p.review.id} detail={p.detail} review={p.review} onClose={close} />;
    case 'accept': return <AcceptDialog key={key} detail={p.detail} onClose={close} />;
    case 'reject': return <RejectDialog key={key} detail={p.detail} onClose={close} />;
    case 'retry': return <RetryDialog key={key} detail={p.detail} onClose={close} />;
    case 'cancel': return <CancelDialog key={key} detail={p.detail} onClose={close} />;
    case 'artifact': return <ArtifactDialog key={p.artifact?.id} artifact={p.artifact} onClose={close} />;
    case 'project-register': return <RegisterProjectDialog key={key} preset={p.preset} onClose={close} />;
    case 'project-edit': return <EditProjectDialog key={key} project={p.project} onClose={close} />;
    case 'project-archive': return <ArchiveProjectDialog key={p.project.id} project={p.project} onClose={close} />;
    case 'project-path': return <AddPathDialog key={key} project={p.project} onClose={close} />;
    case 'add-root': return <AddRootDialog key={key} preset={p.path} onClose={close} />;
    case 'memory': return <MemoryDialog key={key} projectId={p.projectId} onClose={close} />;
    case 'diagram': return <DiagramDialog key={p.diagram?.id} diagram={p.diagram} onClose={close} />;
    case 'agent-edit': return <AgentManageDialog key={p.agent.id} agent={p.agent} modelsOpen={p.modelsOpen} onClose={close} />;
    case 'agent-add': return <AgentManageDialog key={p.preset?.id||'custom'} preset={p.preset} onClose={close} />;
    case 'quota-manage': return <QuotaManageDialog key={p.pool?.id||'new'} pool={p.pool} onClose={close} />;
    case 'resource-remove': return <RemoveResourceDialog key={p.item.id} kind={p.kind} item={p.item} onClose={close} />;
    case 'quota-edit': return <QuotaDialog key={p.pool.id} pool={p.pool} windows={p.windows} onClose={close} />;
    case 'workbuddy-points': return <WorkBuddyPointsDialog key={p.pool.id} pool={p.pool} onClose={close} />;
    case 'subscription-edit': return <SubscriptionEditDialog key={key} subscription={p.subscription} onClose={close} />;
    case 'subscription-add': return <SubscriptionEditDialog key={key} kind={p.kind} onClose={close} />;
    case 'subscription-delete': return <SubscriptionDeleteDialog key={key} subscription={p.subscription} onClose={close} />;
    case 'subscription-confirm': return <SubscriptionConfirmDialog key={key} subscription={p.subscription} onClose={close} />;
    case 'session': return <SessionDialog key={p.session?.id} session={p.session} onClose={close} />;
    default: return null;
  }
}
