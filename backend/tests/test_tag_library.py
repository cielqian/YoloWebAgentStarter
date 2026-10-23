from __future__ import annotations


def test_tag_template_crud_and_sync(client):
    created = client.post("/api/tag-templates", json={"name": "光线", "color": "#f59e0b", "values": ["强", "弱"]})
    assert created.status_code == 201, created.text
    template = created.json()
    assert template["values"] == ["强", "弱"]

    duplicate = client.post("/api/tag-templates", json={"name": "光线"})
    assert duplicate.status_code == 409

    updated = client.patch(f"/api/tag-templates/{template['id']}", json={"values": ["强", "中", "弱"]})
    assert updated.status_code == 200
    assert updated.json()["values"] == ["强", "中", "弱"]

    listed = client.get("/api/tag-templates").json()
    assert [item["name"] for item in listed] == ["光线"]

    # 同步到数据源:创建同名枚举标签
    dataset = client.post("/api/source-datasets", json={"name": "tag-lib-src"}).json()
    synced = client.post(f"/api/tag-templates/sync/{dataset['id']}")
    assert synced.status_code == 200
    tags = client.get(f"/api/source-datasets/{dataset['id']}/tags").json()
    assert len(tags) == 1
    assert tags[0]["name"] == "光线"
    assert tags[0]["values"] == ["强", "中", "弱"]

    # 库更新取值后再同步:数据源标签同步刷新
    client.patch(f"/api/tag-templates/{template['id']}", json={"values": ["弱"]})
    client.post(f"/api/tag-templates/sync/{dataset['id']}")
    tags = client.get(f"/api/source-datasets/{dataset['id']}/tags").json()
    assert tags[0]["values"] == ["弱"]

    removed = client.delete(f"/api/tag-templates/{template['id']}")
    assert removed.status_code == 204
    assert client.get("/api/tag-templates").json() == []
