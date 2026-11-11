import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export class SignupDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty({ minLength: 10 }) @IsString() @Length(10, 200) password!: string;
  @ApiProperty() @Transform(trim) @IsString() @Length(1, 80) name!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(1, 80) workspace_name?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[a-z]{2}(-[A-Z]{2})?$/) locale?: string;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() email!: string;
  @ApiProperty() @IsString() @Length(1, 200) password!: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @Length(20, 200) refresh_token!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workspace_id?: string;
}

export class CreateWorkspaceDto {
  @ApiProperty() @Transform(trim) @IsString() @Length(1, 80) name!: string;
}

export class AddMemberDto {
  @ApiProperty() @Transform(lower) @IsEmail() email!: string;
  @ApiProperty({ enum: ['admin', 'editor', 'viewer'] }) @IsIn(['admin', 'editor', 'viewer']) role!: Role;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES as unknown as string[]) role!: Role;
}
