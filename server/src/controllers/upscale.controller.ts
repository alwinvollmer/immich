// custom: upscaling via the anime-upscaler job API
import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { UpscaleCreateDto, UpscaleJobResponseDto } from 'src/dtos/upscale.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { UpscaleService } from 'src/services/upscale.service.js';

@ApiTags(ApiTag.Assets)
@Controller('upscale')
export class UpscaleController {
  constructor(private service: UpscaleService) {}

  @Post()
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Upscale an image',
    description:
      'Fork addition: upscale an image with the anime upscaler. The result becomes the cover of a stack with the original. Progress is sent as on_upscale_update websocket events.',
    history: new HistoryBuilder().added('v3'),
  })
  createUpscale(@Auth() auth: AuthDto, @Body() dto: UpscaleCreateDto): Promise<UpscaleJobResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('jobs')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'List upscale jobs',
    description: "Fork addition: the current user's running and recently finished upscale jobs.",
    history: new HistoryBuilder().added('v3'),
  })
  getUpscaleJobs(@Auth() auth: AuthDto): UpscaleJobResponseDto[] {
    return this.service.getJobs(auth);
  }
}
