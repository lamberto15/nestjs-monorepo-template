import { Module } from '@nestjs/common';
import { CommentsRegistry } from './comments.registry.js';
import { CommentsService } from './comments.service.js';
import { MentionInboxSource } from './mention.inbox.js';
import { PlatformKernelModule } from '../platform-kernel.module.js';
import { PeopleModule } from '../people/people.module.js';
import { AccountModule } from '../account/account.module.js';
import { InboxModule } from '../inbox/inbox.module.js';

/**
 * The comments capability's providers, exporting what the rest of the platform, IAM,
 * core and the features inject. Imported by PlatformModule
 * (platform.module.ts).
 */
@Module({
  imports: [PlatformKernelModule, PeopleModule, AccountModule, InboxModule],
  providers: [
    // Comments and mentions: features register a CommentTarget and call CommentsService.
    CommentsRegistry,
    CommentsService,
    MentionInboxSource,
  ],
  exports: [CommentsRegistry, CommentsService],
})
export class CommentsModule {}
